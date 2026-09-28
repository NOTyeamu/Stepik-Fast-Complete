using System;

class Program
{
    static void Main()
    {
        int n = int.Parse(Console.ReadLine());
        int sum = 0;
        int i = 1;
        
        while (i <= n)
        {
            sum += i;
            i++;
        }
        
        Console.WriteLine(sum);
    }
}