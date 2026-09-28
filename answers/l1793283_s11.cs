using System;

class Program
{
    static void Main()
    {
        int summa = 0;

        while (true)
        {
            int chislo = int.Parse(Console.ReadLine());

            if (chislo < 0)
            {
                break;
            }

            summa = summa + chislo;
        }

        Console.WriteLine(summa);
    }
}