using System;

class Program
{
    static void Main()
    {
        int temp = int.Parse(Console.ReadLine());
        if (temp > 0)
        {
            Console.WriteLine("Тепло");
        }
        else
        {
            Console.WriteLine("Холодно");
        }
    }
}